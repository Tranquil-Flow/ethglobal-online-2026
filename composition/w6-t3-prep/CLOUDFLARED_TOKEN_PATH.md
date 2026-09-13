# Cloudflared verifier service-token path (Wave 2 T3 prep)

This task intentionally does **not** create the Cloudflare service token. Wave 2 T3 should create it when the Confidential Space verifier endpoint exists.

Documented command to run later:

```bash
cloudflared service token create mycelium-demo/verifier > /Users/evinova-self/.ethonline-testnet/cloudflared-verifier-token.json
chmod 600 /Users/evinova-self/.ethonline-testnet/cloudflared-verifier-token.json
```

Expected JSON path for the future token:

`/Users/evinova-self/.ethonline-testnet/cloudflared-verifier-token.json`

Current file existence at T3-prep run time: `False`

No token JSON was created, read, or logged by T3-prep.

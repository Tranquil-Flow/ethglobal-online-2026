# Native consumer provenance

The native socket consumer in `composition/vendor/a-native-executor-v1.mjs` was inherited untracked from the accepted application handoff. Its pre-takeover bytes are preserved in `workers/integration09-mcp` and bound by `INTEGRATION-TAKEOVER-BASELINE.json`: SHA-256 `04b1084b12e7c1fe6907bca1d847ca7a8dea538494603b395ea687b2936f0f2f`.

It originated from the A-owned `stage-integration-07/serving/executor.mjs` integration surface. This continuation adds an optional validated-terminal-record callback and formats the consumer. It does not copy model weights, change numerical generation, start the A process, or implement the v3 request gateway. Current A source may advance independently; do not equate the app's vendored consumer with a new A runtime or grant. Public binding/source/profile checks remain mandatory.

This is first-party application integration code, with AI-assisted implementation/testing explicitly disclosed. The application's final distribution license and native/model license review are unresolved human release gates; no open-source license is invented here. The archive is a local source handoff, not public publication or an independent security audit.

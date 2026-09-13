import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ISOLATED_FREE_ORIGIN,
  viewerConfigForRequest,
} from "../../live-viewer.mjs";

const config = Object.freeze({
  apiUrl: "https://mycelium.now",
  applicationVersion: "2",
  accessPolicy: "non-economic",
});

test("direct loopback config opts in without changing the configured paid URL", () => {
  assert.deepEqual(
    viewerConfigForRequest({ config, viewerOrigin: ISOLATED_FREE_ORIGIN }),
    { ...config, isolatedFree: true },
  );
});

test("paid or proxied config never exposes isolatedFree true", () => {
  assert.deepEqual(
    viewerConfigForRequest({ config, viewerOrigin: "http://127.0.0.1:4352" }),
    config,
  );
  assert.deepEqual(
    viewerConfigForRequest({
      config,
      viewerOrigin: ISOLATED_FREE_ORIGIN,
      headers: { "x-forwarded-proto": "https" },
    }),
    config,
  );
});
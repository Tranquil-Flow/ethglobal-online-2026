import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, queryProviderHistory } from "../src/index.mjs";
import { assessment, event, providerId } from "./fixtures.mjs";
import { config, graphData } from "./history.test.mjs";

const hex = (d) => "0x" + d.slice(7);
const hash = "0x" + "a".repeat(64);
const openAddress = "0x" + "2".repeat(40);

function openGraphData() {
  const data = graphData();
  data.assessmentClaims = [];
  data.openAssessmentClaims = [
    {
      id: "synthetic-open-log",
      statementDigest: "0x" + "4".repeat(64),
      objectDigest: hex(event.objectDigest),
      receiptDigest: hex(event.receiptDigest),
      providerKey: hex(event.providerKey),
      verifierKey: hex(event.verifierKey),
      methodKey: hex(event.methodKey),
      outcome: 1,
      mode: 0,
      publicMetadata: JSON.stringify(assessment),
      valid: true,
      linked: false,
      chainId: "31337",
      contractAddress: openAddress,
      author: "0x" + "3".repeat(40),
      relayer: "0x" + "4".repeat(40),
      transactionHash: hash,
      blockNumber: "9",
      blockHash: hash,
      logIndex: "1",
    },
  ];
  return data;
}

test("history consumes open checker-signed v2 claims without requiring a v1 receipt", async () => {
  const report = await queryProviderHistory({
    config: {
      ...config,
      deployment: { ...config.deployment, openRegistryAddress: openAddress },
    },
    client: {
      async query() {
        return openGraphData();
      },
    },
    providerId,
  });
  assert.equal(report.history.freshness, "fresh");
  assert.deepEqual(report.history.observations, [assessment]);
  assert.equal(
    report.provenance[0].statementDigest,
    "sha256:" + "4".repeat(64),
  );
  assert.equal(report.provenance[0].author, "0x" + "3".repeat(40));
  assert.equal(report.provenance[0].publisher, undefined);
  assert.deepEqual(report.reasons, ["UNKNOWN_VERIFIER"]);
});

test("history rejects malformed open claims instead of mixing them into provider selection", async () => {
  for (const [name, mutate] of [
    [
      "bad contract",
      (d) =>
        (d.openAssessmentClaims[0].contractAddress = config.deployment.address),
    ],
    [
      "private projection",
      (d) =>
        (d.openAssessmentClaims[0].publicMetadata = JSON.stringify({
          ...assessment,
          prompt: "canary",
        })),
    ],
    ["unvalidated mapping", (d) => (d.openAssessmentClaims[0].valid = false)],
    [
      "linked as receipt proof",
      (d) => (d.openAssessmentClaims[0].linked = true),
    ],
  ]) {
    const data = openGraphData();
    mutate(data);
    const h = await createHistory({
      config: {
        ...config,
        deployment: { ...config.deployment, openRegistryAddress: openAddress },
      },
      client: {
        async query() {
          return data;
        },
      },
    }).getHistory({ providerId });
    assert.equal(h.freshness, "unavailable", name);
    assert.deepEqual(h.observations, [], name);
  }
});

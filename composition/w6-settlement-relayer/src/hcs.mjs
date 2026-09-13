import { bytes32 } from "./eip712.mjs";

export async function publishHcsDigest({ topicId, digest, client } = {}) {
  bytes32(digest, "digest");
  if (!topicId) return { skipped: true, reason: "HCS_TOPIC_NOT_CONFIGURED" };
  if (!client?.publishMessage) {
    return { skipped: true, reason: "HCS_CLIENT_NOT_CONFIGURED", topicId };
  }
  // Optional prize-bonus path only. The relayer never broadcasts in tests; callers must inject
  // a client that itself obeys the broadcast guard and returns a receipt.
  const receipt = await client.publishMessage({ topicId, message: digest });
  return { skipped: false, topicId, digest, receipt };
}

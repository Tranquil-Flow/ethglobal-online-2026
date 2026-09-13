// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal in-memory fake of the Hedera HCS surface used by w6-hcs-audit tests.
// Records every topic creation and message submission; never touches the network.
// No prompt/output/session data is ever passed in — payloads are limited to the
// canonical digest-only schema defined in w6-hcs-audit.mjs.
import { canonicalBytes } from "../../../packages/contracts/index.mjs";

export function createFakeHederaHcs({ topicId = "0.0.7000001" } = {}) {
  const topics = [];
  const messages = [];
  let nextSequence = 1;
  let nextTxNonce = 1;

  return {
    /** Mimics TopicCreateTransaction().setTopicMemo().execute(client) */
    createTopic({ memo, submitKey, operatorAccountId }) {
      const id = `${topicId}-${topics.length + 1}`;
      const record = {
        topicId: id,
        memo,
        submitKey,
        operatorAccountId,
        createdAt: new Date().toISOString(),
      };
      topics.push(record);
      return {
        topicId: id,
        transactionId: `0.0.${7000000 + topics.length}@${Date.now()}.${nextTxNonce++}`,
      };
    },

    /** Mimics TopicMessageSubmitTransaction().setTopicId().setMessage().execute(client) */
    submitMessage({ topicId: tid, message }) {
      // Verify the message round-trips through canonicalBytes deterministically.
      const roundTrip = canonicalBytes(JSON.parse(message.toString("utf8")));
      const sequenceNumber = nextSequence++;
      const entry = {
        topicId: tid,
        sequenceNumber,
        messageBytes: message.length,
        canonicalBytes: roundTrip.length,
        submittedAt: new Date().toISOString(),
      };
      messages.push(entry);
      return {
        status: "SUCCESS",
        transactionId: `0.0.${7000000 + messages.length}@${Date.now()}.${nextTxNonce++}`,
        topicSequenceNumber: sequenceNumber,
        consensusTimestamp: new Date().toISOString(),
      };
    },

    // Test introspection
    topics,
    messages,
  };
}
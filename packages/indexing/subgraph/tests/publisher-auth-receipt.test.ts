import {
  test,
  assert,
  newMockEvent,
  clearStore,
  dataSourceMock,
  beforeEach,
  createMockedFunction,
} from "matchstick-as/assembly/index";
import {
  ethereum,
  Bytes,
  BigInt,
  DataSourceContext,
  Address,
} from "@graphprotocol/graph-ts";
import { ReceiptPublished } from "../generated/Registry/Registry";
import { handleReceipt } from "../src/mapping";

// Sepolia configuration reproduced from subgraph.yaml for the live publisher.
const CHAIN_ID = "11155111";
const LIVE_MODE: i32 = 1;
const REAL_PUBLISHER = "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE";
// Bytes->toHexString() lowercases; field 'publisher' is stored as the hex of the publisher address.
const REAL_PUBLISHER_LOWER = "0xb4f0b42fbb0fcaf62703475039a7e26ef6dd5eae";
const REGISTRY_ADDRESS = "0x9fd43d7b41c82406a776b700702eea3813ac426a";  // lowercase to match Address.toHexString() used by mapping.ts when building ids
const RECEIPT_DIGEST =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const PROVIDER_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

function liveContext(publisher: string): DataSourceContext {
  let c = new DataSourceContext();
  c.setString("chainId", CHAIN_ID);
  c.setI32("mode", LIVE_MODE);
  c.setBytes("publisher", Bytes.fromHexString(publisher));
  return c;
}

function receiptEvent(): ReceiptPublished {
  let e = changetype<ReceiptPublished>(newMockEvent());
  e.address = Address.fromString(REGISTRY_ADDRESS);
  e.parameters = [
    new ethereum.EventParam(
      "receiptDigest",
      ethereum.Value.fromFixedBytes(Bytes.fromHexString(RECEIPT_DIGEST))
    ),
    new ethereum.EventParam(
      "providerKey",
      ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROVIDER_KEY))
    ),
    new ethereum.EventParam("mode", ethereum.Value.fromI32(LIVE_MODE)),
  ];
  return e;
}

beforeEach(() => {
  clearStore();
});

test("live publisher on Sepolia creates a ReceiptClaim attributed to that publisher", () => {
  dataSourceMock.setAddressAndContext(
    REGISTRY_ADDRESS,
    liveContext(REAL_PUBLISHER)
  );
  createMockedFunction(
    Address.fromString(REGISTRY_ADDRESS),
    "publisher",
    "publisher():(address)"
  ).returns([
    ethereum.Value.fromAddress(Address.fromString(REAL_PUBLISHER)),
  ]);
  handleReceipt(receiptEvent());
  assert.entityCount("ReceiptClaim", 1);
  let id = CHAIN_ID + ":" + REGISTRY_ADDRESS + ":receipt:" + RECEIPT_DIGEST;
  assert.fieldEquals("ReceiptClaim", id, "chainId", CHAIN_ID);
  assert.fieldEquals("ReceiptClaim", id, "mode", "1");
  assert.fieldEquals("ReceiptClaim", id, "publisher", REAL_PUBLISHER_LOWER);
  assert.fieldEquals("ReceiptClaim", id, "providerKey", PROVIDER_KEY);
});

test("a receipt attributed to a different publisher does not create a ReceiptClaim", () => {
  // Context claims the real publisher; on-chain publisher is a stranger.
  dataSourceMock.setAddressAndContext(
    REGISTRY_ADDRESS,
    liveContext(REAL_PUBLISHER)
  );
  createMockedFunction(
    Address.fromString(REGISTRY_ADDRESS),
    "publisher",
    "publisher():(address)"
  ).returns([
    ethereum.Value.fromAddress(
      Address.fromString("0x" + "99".repeat(20))
    ),
  ]);
  handleReceipt(receiptEvent());
  assert.entityCount("ReceiptClaim", 0);
});

test("a receipt with the wrong mode is filtered out on the live data source", () => {
  dataSourceMock.setAddressAndContext(
    REGISTRY_ADDRESS,
    liveContext(REAL_PUBLISHER)
  );
  createMockedFunction(
    Address.fromString(REGISTRY_ADDRESS),
    "publisher",
    "publisher():(address)"
  ).returns([
    ethereum.Value.fromAddress(Address.fromString(REAL_PUBLISHER)),
  ]);
  let e = receiptEvent();
  e.parameters = [
    new ethereum.EventParam(
      "receiptDigest",
      ethereum.Value.fromFixedBytes(Bytes.fromHexString(RECEIPT_DIGEST))
    ),
    new ethereum.EventParam(
      "providerKey",
      ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROVIDER_KEY))
    ),
    // dev-mode receipt on a live-mode data source must be ignored
    new ethereum.EventParam("mode", ethereum.Value.fromI32(0)),
  ];
  handleReceipt(e);
  assert.entityCount("ReceiptClaim", 0);
});

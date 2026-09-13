export const WAVE6_GRAPH_STUDIO_ENDPOINT =
  "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile";
export const WAVE6_DEFAULT_SEPOLIA_RPC =
  "https://ethereum-sepolia-rpc.publicnode.com";

/** Build the closed Wave 6 Graph history input without reducing confirmation depth. */
export function wave6GraphHistorySpec(env = process.env) {
  return {
    endpoint: WAVE6_GRAPH_STUDIO_ENDPOINT,
    rpcUrl: env.SEPOLIA_RPC ?? WAVE6_DEFAULT_SEPOLIA_RPC,
    deployment: {
      mode: "live",
      chainId: 11155111,
      network: "sepolia",
      address: "0x9fd43D7b41c82406A776b700702EEA3813ac426A",
      publisher: "0xb4f0b42fbb0fcaf62703475039a7e26ef6dd5eae",
      deploymentId: "QmZo3C1H3DgDnRB54SVrMWGUvtmS5ajzeADxAyD62TX2gZ",
      codeHash: "0x" + "55".repeat(32),
      startBlock: 11660509,
      confirmations: 12,
    },
    deploymentId: "QmZo3C1H3DgDnRB54SVrMWGUvtmS5ajzeADxAyD62TX2gZ",
    publicEndpoint: WAVE6_GRAPH_STUDIO_ENDPOINT,
  };
}

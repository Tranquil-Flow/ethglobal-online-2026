import { validateDeployment } from "./config.mjs";
import { failure } from "./common.mjs";

export function validateManifest(manifest, deployment) {
  const d = validateDeployment(deployment);
  try {
    if (
      manifest.dataSources?.length !== 2 ||
      manifest.templates?.length ||
      !d.openRegistryAddress
    )
      throw 0;
    const s = manifest.dataSources[0];
    if (
      s.name !== "Registry" ||
      s.kind !== "ethereum/contract" ||
      s.network !== d.network ||
      s.source.address.toLowerCase() !== d.address.toLowerCase() ||
      s.source.startBlock !== d.startBlock ||
      s.source.abi !== "Registry" ||
      String(s.context.chainId.data) !== String(d.chainId) ||
      s.context.mode.data !== (d.mode === "development" ? 0 : 1) ||
      s.context.publisher.data.toLowerCase() !== d.publisher.toLowerCase()
    )
      throw 0;
    const handlers = s.mapping.eventHandlers;
    if (
      handlers.length !== 2 ||
      handlers[0].event !==
        "ReceiptPublished(indexed bytes32,indexed bytes32,uint8)" ||
      handlers[0].handler !== "handleReceipt" ||
      handlers[1].event !==
        "AssessmentPublished(indexed bytes32,indexed bytes32,indexed bytes32,bytes32,bytes32,uint8,uint8,string)" ||
      handlers[1].handler !== "handleAssessment" ||
      s.mapping.file !== "./src/mapping.ts"
    )
      throw 0;
    const o = manifest.dataSources[1];
    if (
      o.name !== "RegistryV2" ||
      o.kind !== "ethereum/contract" ||
      o.network !== d.network ||
      o.source.address.toLowerCase() !== d.openRegistryAddress.toLowerCase() ||
      o.source.startBlock !== d.startBlock ||
      o.source.abi !== "RegistryV2" ||
      String(o.context.chainId.data) !== String(d.chainId) ||
      o.context.mode.data !== (d.mode === "development" ? 0 : 1) ||
      Object.hasOwn(o.context, "publisher")
    )
      throw 0;
    const openHandlers = o.mapping.eventHandlers;
    if (
      openHandlers.length !== 1 ||
      openHandlers[0].event !==
        "OpenAssessmentPublished(indexed bytes32,indexed bytes32,indexed bytes32,address,address,bytes32,bytes32,uint8,uint8,bool,string)" ||
      openHandlers[0].handler !== "handleOpenAssessment" ||
      o.mapping.file !== "./src/mapping-v2.ts"
    )
      throw 0;
    return true;
  } catch {
    throw failure("MANIFEST_MISMATCH");
  }
}

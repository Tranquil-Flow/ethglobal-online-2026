
import { validate } from "../packages/contracts/index.mjs";
const r = {
  version: "1", nonce: "3e3af30554e83e733f33654e94a2e6748374fec5222981344c1e242348d211c8",
  sampling: "greedy",
  providerId: "service.ethonline-node-a.eth",
  profileId: "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c",
  prompt: "hello",
  maxOutputTokens: 8,
  seed: 0,
  publishConsent: true,
};
try {
  validate("Request", r);
  console.log("validate OK");
} catch (e) {
  console.log("FAIL:", e.message);
}

import { createSqliteStore, paymentConfigurationBinding } from "../packages/payments/src/index.mjs";

/**
 * One explicit retained-store migration used only after the selected managed
 * config has been durably replaced. Quote-only state may be discarded because
 * it carries no settlement; any retained payment/job/refund remains fail-closed.
 */
export function reconcilePaymentStoreConfiguration({ path, config, configWritten }) {
  if (configWritten !== true) throw new Error("PAYMENT_CONFIG_NOT_WRITTEN");
  const store = createSqliteStore({ path });
  try {
    const binding = paymentConfigurationBinding({ ...config, databasePath: path });
    return store.transaction(() => store.reconcileConfigurationBinding(binding));
  } finally {
    store.close();
  }
}

/** Local test infrastructure only. A failed database-pool startup can strand an
 * otherwise valid assigned subgraph. Restart the owned Graph process at most once;
 * every success still comes from the unchanged real index-readiness check. */
export async function recoverInitialGraphIndex({readIndex,readLogs,restart,record}) {
  try { return await readIndex(); }
  catch (error) {
    if (error.message !== "LOCAL_READINESS_TIMEOUT: initial registry index") throw error;
    const logs = await readLogs();
    if (!/Subgraph failed to start[^\n]*database unavailable/.test(logs)) throw error;
    await record(logs);
    await restart();
    return readIndex(); // No recursive recovery and no fabricated metadata.
  }
}

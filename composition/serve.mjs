import { startDevelopment } from "./index.mjs";
const args = process.argv.slice(2),
  options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--development") options.development = true;
  else if (args[i] === "--data-dir") options.dataDir = args[++i];
  else if (args[i] === "--port") options.port = Number(args[++i]);
  else if (args[i] === "--delay-ms") options.delayMs = Number(args[++i]);
  else throw Error("UNKNOWN_OPTION");
}
let app;
try {
  app = await startDevelopment(options);
  console.log(
    JSON.stringify({
      url: app.url,
      providerId: app.providerId,
      profileId: app.profileId,
      pins: app.pins,
      mode: "development",
      execution: "synthetic-not-inference",
      assessment: "unavailable",
      payment: "offline-synthetic-no-funds",
      history: "synthetic-Graph-shaped-not-deployed",
    }),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () =>
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
    );
} catch (e) {
  await app?.close();
  console.error(
    [
      "DEVELOPMENT_REQUIRED",
      "PRIVATE_DIRECTORY_REQUIRED",
      "INVALID_LOCAL_CONFIG",
    ].includes(e.message)
      ? e.message
      : "LOCAL_START_FAILED; use supported Node and a private data directory, check occupied ports",
  );
  process.exitCode = 1;
}

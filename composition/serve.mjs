import { startDevelopment } from "./index.mjs";
const args = process.argv.slice(2),
  options = {};
let useLocalServices = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--local-services") useLocalServices = true;
  else if (args[i] === "--development") options.development = true;
  else if (args[i] === "--data-dir") options.dataDir = args[++i];
  else if (args[i] === "--port") options.port = Number(args[++i]);
  else if (args[i] === "--delay-ms") options.delayMs = Number(args[++i]);
  else throw Error("UNKNOWN_OPTION");
}
let app, rehearsal;
async function close(){try{await app?.close();}finally{await rehearsal?.close();}}
try {
  if(useLocalServices){
    if(options.development!==true)throw Error("DEVELOPMENT_REQUIRED");
    const {startRehearsalInfrastructure}=await import("./local-rehearsal.mjs");
    rehearsal=await startRehearsalInfrastructure();
    options.localInfrastructure=rehearsal.descriptor;options.providerId="worker.example.eth";
  }
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
      history: useLocalServices ? "local-Graph-Node-not-public-provider" : "synthetic-Graph-shaped-not-deployed",
      discovery: useLocalServices ? "local-ENSv2-contracts" : "synthetic-records-not-ENS",
    }),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () =>
      close().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
    );
} catch (e) {
  await close();
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

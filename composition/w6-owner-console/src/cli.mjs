#!/usr/bin/env node
import { startOwnerConsole } from "./server.mjs";

try {
  const app = await startOwnerConsole();
  process.stdout.write(`${JSON.stringify({status:"owner-console-serving",url:app.url,loopbackOnly:true})}\n`);
  for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,async()=>{await app.close();process.exit(0)});
} catch (error) {
  process.stderr.write(`${JSON.stringify({status:"owner-console-refused",code:error?.message??"START_FAILED"})}\n`);
  process.exitCode=78;
}

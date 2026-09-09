import { spawn } from "node:child_process";
import { once } from "node:events";
export async function startAppChild(configPath, descriptorPath) {
  const child = spawn(
    process.execPath,
    [
      "composition/serve.mjs",
      "--config",
      configPath,
      "--bindings",
      "composition/test/fixtures/v3-bindings.mjs",
    ],
    {
      env: { ...process.env, C_UC1_PRIVATE_DESCRIPTOR: descriptorPath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let buffer = "",
    errors = "";
  child.stderr.on("data", (b) => (errors = (errors + b).slice(-4096)));
  try {
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("APP_START_TIMEOUT")), 90000);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("APP_START_FAILED:" + errors));
      });
      child.stdout.on("data", (b) => {
        buffer += b;
        for (const line of buffer.split("\n")) {
          try {
            const data = JSON.parse(line);
            if (data.url) {
              clearTimeout(timer);
              resolve(data);
            }
          } catch {}
        }
        buffer = buffer.slice(-8192);
      });
    });
    return {
      info,
      async close() {
        child.kill("SIGTERM");
        let timer;
        try {
          const [code] = await Promise.race([
            exited,
            new Promise((_, r) => {
              timer = setTimeout(() => r(Error("APP_CLOSE_TIMEOUT")), 30000);
            }),
          ]);
          if (code !== 0) throw Error("APP_CLOSE_FAILED");
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (e) {
    child.kill("SIGTERM");
    await exited;
    throw e;
  }
}
export async function childJson(args, env = process.env) {
  const p = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  p.stdout.on("data", (b) => (output += b));
  p.stderr.resume();
  const timer = setTimeout(() => p.kill("SIGTERM"), 20000);
  try {
    const [code] = await once(p, "exit");
    if (code !== 0) throw Error("CLIENT_FAILED:" + code);
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
  }
}

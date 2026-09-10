import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { resolve } from "node:path";
export async function startGatewayFixture() {
  const root = process.env.MYCELIUM_C_UC1_SOURCE;
  if (!root)
    throw Error(
      "MYCELIUM_C_UC1_SOURCE_REQUIRED: explicit isolated conformance source checkout",
    );
  const child = spawn(
    process.env.C_UC1_PYTHON || "python3",
    [resolve(root, "scripts/c_uc1_application_fixture.py")],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: "", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const next = async () => {
    let timer;
    try {
      return await Promise.race([
        lines.next().then((x) => {
          if (x.done) throw Error("GATEWAY_FIXTURE_EOF");
          return JSON.parse(x.value);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("GATEWAY_FIXTURE_TIMEOUT")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const descriptor = await next();
    if (descriptor.protocol !== "c-uc1.application-fixture.v1")
      throw Error("GATEWAY_FIXTURE_INVALID");
    let pending = Promise.resolve();
    return {
      descriptor,
      command(c) {
        const result = pending.then(() => {
          child.stdin.write(JSON.stringify(c) + "\n");
          return next();
        });
        pending = result.catch(() => {});
        return result;
      },
      async close() {
        const exited = once(child, "exit");
        child.stdin.write('"close"\n');
        const end = await next();
        if (!end.closed) throw Error("GATEWAY_CLOSE_UNPROVEN");
        const [code] = await exited;
        if (code !== 0) throw Error("GATEWAY_CLOSE_FAILED");
      },
    };
  } catch (e) {
    child.kill("SIGTERM");
    throw e;
  }
}

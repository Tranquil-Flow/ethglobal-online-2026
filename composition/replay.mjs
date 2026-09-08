import { open, constants } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { replayEvidence } from "./runtime.mjs";

async function privateJson(path) {
  if (typeof path !== "string" || !path) throw Error("PRIVATE_INPUT_REQUIRED");
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.mode & 0o077 ||
      s.size > 2097152
    )
      throw Error("PRIVATE_INPUT_REQUIRED");
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
export async function runReplay(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !["--evidence", "--pins"].includes(argv[i]) ||
      options[argv[i]] ||
      !argv[i + 1]
    )
      throw Error("REPLAY_ARGUMENTS_REQUIRED");
    options[argv[i]] = argv[i + 1];
  }
  const [bundle, pins] = await Promise.all([
    privateJson(options["--evidence"]),
    privateJson(options["--pins"]),
  ]);
  return replayEvidence({ bundle, pins });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const assessment = await runReplay(process.argv.slice(2));
    console.log(JSON.stringify(assessment));
    process.exitCode = assessment.outcome === "passed" ? 0 : 2;
  } catch {
    console.error(
      "REPLAY_INPUT_UNAVAILABLE; requires owner-only evidence and pinned public-key files",
    );
    process.exitCode = 1;
  }
}

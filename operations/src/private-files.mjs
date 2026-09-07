import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function assertPrivateDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw coded("UNSAFE_SOURCE");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw coded("UNSAFE_SOURCE");
  return resolve(path);
}

export function assertSafeParent(path) {
  const parent = dirname(resolve(path));
  let stat;
  try { stat = lstatSync(parent); } catch { throw coded("UNSAFE_DESTINATION"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw coded("UNSAFE_DESTINATION");
  // Resolve once to ensure the final parent itself still exists and is a directory.
  realpathSync(parent);
  return parent;
}

export function readPrivateFile(path, { maxBytes = 128 * 1024 * 1024, code = "UNSAFE_SOURCE" } = {}) {
  let before;
  try { before = lstatSync(path); } catch { throw coded(code); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
      before.size < 1 || before.size > maxBytes ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) throw coded(code);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw coded(code);
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    return { data, stat: after };
  } catch (error) {
    if (error?.code === code) throw error;
    throw coded(code);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function sameFileState(path, stat) {
  try {
    const now = lstatSync(path);
    return now.isFile() && !now.isSymbolicLink() && now.nlink === 1 && now.dev === stat.dev && now.ino === stat.ino &&
      now.size === stat.size && now.mtimeMs === stat.mtimeMs && now.ctimeMs === stat.ctimeMs;
  } catch { return false; }
}

export function writePrivateExclusive(path, bytes) {
  let fd;
  let created = false;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (created) { try { unlinkSync(path); } catch {} }
    if (error?.code === "EEXIST") throw coded("DESTINATION_EXISTS");
    if (error?.code && /^[A-Z_]+$/.test(error.code) && !error.code.startsWith("E")) throw error;
    throw coded("WRITE_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

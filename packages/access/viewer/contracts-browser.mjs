import * as validators from "../dist/validators.mjs";
import { canonicalize } from "json-canonicalize";
function json(value, seen = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isSafeInteger(value)) return;
  if (
    typeof value !== "object" ||
    seen.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw Error("INVALID_JSON");
  seen.add(value);
  if (Reflect.ownKeys(value).some((k) => typeof k === "symbol"))
    throw Error("INVALID_JSON");
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw Error("INVALID_JSON");
    for (const v of value) json(v, seen);
  } else
    for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!d.enumerable || !("value" in d)) throw Error("INVALID_JSON");
      json(d.value, seen);
    }
  seen.delete(value);
}
export function validate(name, value) {
  json(value);
  if (!validators[name]?.(value)) throw Error("INVALID_DTO");
  return true;
}
export function canonicalBytes(value) {
  json(value);
  return new TextEncoder().encode(canonicalize(value));
}
export async function digestOf(value) {
  const hash = await crypto.subtle.digest("SHA-256", canonicalBytes(value));
  return (
    "sha256:" +
    Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}

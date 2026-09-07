export class AccessError extends Error {
  constructor(code, status = 0, retryable = false) {
    super(code);
    this.name = "AccessError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
export function fail(code, status = 0) {
  throw new AccessError(code, status);
}
export function checked(validate, name, value, response = false) {
  try {
    validate(name, value);
  } catch {
    fail(response ? "INVALID_RESPONSE" : "INVALID_INPUT");
  }
  return value;
}
export function exact(value, keys, required = keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    fail("INVALID_RESPONSE");
  return value;
}
export const id = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\r\n]/.test(value);

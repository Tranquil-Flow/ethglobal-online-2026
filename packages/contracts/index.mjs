import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalize } from 'json-canonicalize';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map(Object.keys(schema.$defs).map(name => [name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })]));

// Wire values are JSON with safe integers, never JS objects with custom serialization.
function assertJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Expected acyclic JSON with safe integer numbers');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Expected plain JSON object');
  seen.add(value);
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) throw new TypeError('Symbol keys are not JSON');
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('Sparse or extended arrays are not supported');
    for (let i = 0; i < value.length; i++) assertJson(value[i], seen);
  } else {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Expected enumerable JSON data properties');
      assertJson(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

export function validate(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new TypeError(`Unknown schema: ${name}`);
  assertJson(value);
  if (!validator(value)) {
    // Do not echo input values; payloads may contain private prompts.
    throw new TypeError(`Invalid ${name}: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
  }
  return true;
}

export function canonicalBytes(value) {
  assertJson(value);
  return Buffer.from(canonicalize(value), 'utf8');
}
export function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalBytes(value)).digest('hex')}`;
}
export function requestHash(request) {
  validate('Request', request);
  return digestOf(request);
}

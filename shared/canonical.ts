import { sha256, toUtf8Bytes } from "ethers";

/**
 * Canonical JSON utilities — isomorphic (browser + node).
 *
 * Canonicalization here means: a total, deterministic serialization of a JSON
 * value such that two structurally-equal values always produce byte-identical
 * output regardless of key insertion order. Object keys are sorted recursively
 * (by UTF-16 code unit, the JS default string order); arrays keep their order
 * (array order is semantically significant); primitives serialize as strict
 * JSON. This lets any party — including the player's own browser — recompute
 * the exact hashes that were committed on-chain.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Produce a canonical JSON string with recursively sorted object keys.
 * Rejects values that JSON cannot represent losslessly and deterministically
 * (NaN, Infinity, undefined, functions, symbols, bigint) rather than silently
 * coercing them.
 */
export function canonicalJSONStringify(value: JsonValue): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error(
        `canonicalJSONStringify: non-finite number is not representable: ${String(n)}`,
      );
    }
    // JSON.stringify gives the shortest round-trippable representation.
    return JSON.stringify(n);
  }

  if (t === "string") {
    return JSON.stringify(value as string);
  }

  if (t === "bigint") {
    throw new Error("canonicalJSONStringify: bigint is not JSON-representable");
  }

  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new Error(`canonicalJSONStringify: value of type ${t} is not JSON-representable`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      // Match JSON.stringify object semantics: skip keys whose value is undefined.
      if (typeof v === "undefined") continue;
      parts.push(`${JSON.stringify(key)}:${encode(v)}`);
    }
    return `{${parts.join(",")}}`;
  }

  throw new Error("canonicalJSONStringify: unsupported value");
}

/**
 * SHA-256 of the canonical JSON encoding, as a 0x-prefixed 32-byte hex string.
 * Implemented with ethers' sha256 so the identical code path runs in node and
 * in the player's browser (byte-for-byte identical output to node:crypto).
 */
export function canonicalHash(value: JsonValue): string {
  return sha256(toUtf8Bytes(canonicalJSONStringify(value)));
}

/** SHA-256 of a UTF-8 string, 0x-prefixed hex. */
export function sha256Utf8(s: string): string {
  return sha256(toUtf8Bytes(s));
}

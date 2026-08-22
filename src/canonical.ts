import { createHash } from "node:crypto";

/**
 * Canonical JSON utilities.
 *
 * Canonicalization here means: a total, deterministic serialization of a JSON
 * value such that two structurally-equal values always produce byte-identical
 * output regardless of key insertion order. Object keys are sorted recursively
 * (by UTF-16 code unit, the JS default string order); arrays keep their order
 * (array order is semantically significant); primitives serialize as strict
 * JSON. This lets us hash evidence manifests deterministically for on-chain
 * commitment.
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
 * Deterministic keccak-independent SHA-256 hash of the canonical JSON encoding.
 * Returns a 0x-prefixed 32-byte hex string. Used for the evidence manifest hash
 * committed on-chain (the contract stores whatever 32-byte hash we hand it; we
 * standardize on sha256 of canonical JSON so a verifier can recompute it).
 */
export function canonicalHash(value: JsonValue): string {
  const canonical = canonicalJSONStringify(value);
  const digest = createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
  return `0x${digest}`;
}

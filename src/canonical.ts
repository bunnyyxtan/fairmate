/**
 * Canonical JSON utilities.
 *
 * The implementation lives in shared/canonical.ts so the exact same code runs
 * in the player's browser (hash re-verification) and in node (referee,
 * scripts, CLI verifier). This module re-exports it for the node-side core.
 */
export { canonicalJSONStringify, canonicalHash, sha256Utf8, type JsonValue } from "../shared/canonical.js";

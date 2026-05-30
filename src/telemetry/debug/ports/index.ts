/**
 * Telemetry debug port interfaces.
 *
 * Product runtime can expose YaosDebugPort (safe, read-only capabilities).
 * Mutation harness (Puppeteer) in qa/ has its own unsafe port definitions.
 *
 * This module must never re-export YaosUnsafeQaPort — that interface lives
 * in qa/ and is not part of the telemetry/Observer contract.
 */

export type { YaosDebugPort, EditorBindingHealth, ReceiptSnapshot } from "./yaosDebugPort";

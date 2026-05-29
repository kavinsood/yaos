/**
 * Debug/QA port interfaces.
 *
 * Product runtime can expose YaosDebugPort (safe capabilities).
 * QA scenario control must go through YaosUnsafeQaPort (gated by qaDebugMode).
 *
 * src/sync/ and src/runtime/ should NEVER import YaosUnsafeQaPort or
 * qaDebugApi directly. Use the guard:qa-isolation script to verify.
 */

export type { YaosDebugPort, EditorBindingHealth, ReceiptSnapshot } from "./yaosDebugPort";
export type { YaosUnsafeQaPort } from "./yaosUnsafeQaPort";

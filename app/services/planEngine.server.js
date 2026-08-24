/**
 * Server-side entry point for the plan feature & limit configuration.
 *
 * The definitions live in `planConfig.js` (no `.server` suffix) because the
 * Admin portal renders plan names, prices and `normalizePlanId` in the browser
 * as well. A `.server.js` module cannot be bundled for the client, so importing
 * this file from component code breaks the client bundle and the page ships
 * without hydration - every button on it goes dead. Client code must import
 * `./planConfig.js` directly; this shim only exists so the many server-side
 * callers keep working unchanged.
 */

export * from "./planConfig.js";

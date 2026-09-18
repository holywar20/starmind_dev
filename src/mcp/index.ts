/**
 * The vendored MCP wire — starmind_dev's own copy of the server substrate, taken from
 * `daedalus/src/mcp/` on 2026-08-23, which took it from `kcd_sdk/src/server/` on 2026-07-22.
 *
 * WHY A THIRD COPY RATHER THAN AN IMPORT. This is duplication and it is deliberate. daedalus
 * is its own repository with its own remote and its own release cadence; starmind_dev is a
 * TEST rig, and a test rig that stops working because a product component refactored is a
 * test rig that fails exactly when something is being changed — which is the only time it
 * matters. Protocol code is also the cheapest possible thing to duplicate: it implements a
 * published spec, so it changes when the spec changes and not when this project does.
 *
 * Divergence from either original is expected, not a defect. Read `./McpServer.ts`'s header
 * before changing anything here.
 *
 * NOT VENDORED, and each omission is load-bearing:
 *
 *  • `manifest.ts` — the `ServerManifest` type is Starmind plugin interop. starmind_dev is
 *    explicitly NOT a Starmind plugin and must never become one, so it does not merely
 *    decline to fill a manifest out: it does not possess the concept. Starmind's
 *    `promote:mcp` identifies a server by finding a manifest-bearing export, which means
 *    this omission is what makes "never ships" structural rather than a promise. There is
 *    nothing here for the discovery pass to find.
 *
 *  • `verify.ts` — the TestSpec harness. Wanted eventually, but it belongs beside tools that
 *    have assertions worth running, and the cold tools land first. Adding it now would be
 *    vendoring a harness for specs nobody has written.
 */
export { McpServer } from './McpServer';
export type { ContentBlock, ToolResult, ToolAnnotations, ToolDefinition, ServerInfo } from './McpServer';

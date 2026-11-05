// Lodestar 1.43.0 and @chainsafe/ssz assume Node globals, so they throw ReferenceError in browsers:
// - @lodestar/utils runs `"bun" in process.versions` at module load (lib/fetch.js);
// - Lodestar and ssz use Buffer throughout.
// Define them only where they are missing. The `process` stand-in has no `versions.node`, so
// environment checks still see a browser. This module must be evaluated before any Lodestar module.
import { Buffer } from "buffer/"; // trailing slash: the npm polyfill, not the Node built-in name

const g = globalThis as { process?: unknown; Buffer?: unknown };
if (typeof g.process === "undefined") g.process = { env: {}, versions: {} };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;

export {};

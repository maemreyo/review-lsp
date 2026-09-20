import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { verifyDependencySnapshot } from "../dist/src/index.js";

const [descriptorPath] = process.argv.slice(2);
if (!descriptorPath) throw new Error("usage: benchmark-verify-snapshot.mjs <descriptor.json>");
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
const started = performance.now();
await verifyDependencySnapshot(descriptor);
process.stdout.write(JSON.stringify({
  verification_ms: performance.now() - started,
  snapshot_id: descriptor.snapshot_id,
}) + "\n");

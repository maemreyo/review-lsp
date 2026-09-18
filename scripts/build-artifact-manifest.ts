import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildArtifactManifest } from "../src/core/artifact.js";

const root = resolve(process.cwd());
const manifest = await buildArtifactManifest(root);
await writeFile(resolve(root, "dist", "review-lsp-artifact.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`${manifest.artifact_id} ${manifest.artifact_sha256}\n`);

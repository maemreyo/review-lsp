import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";

const require = createRequire(import.meta.url);
const source = require.resolve("typescript-language-server/package.json");
await mkdir("dist/typescript-language-server", { recursive: true });
await copyFile(source, "dist/typescript-language-server/package.json");

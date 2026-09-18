import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const root = resolve(process.cwd());
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const require = createRequire(resolve(root, "package.json"));
const rows = [];

async function findPackageRoot(name) {
  let resolved;
  try {
    resolved = require.resolve(`${name}/package.json`);
  } catch {
    resolved = require.resolve(name);
  }
  let current = dirname(resolved);
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      const candidate = JSON.parse(await readFile(resolve(current, "package.json"), "utf8"));
      if (candidate.name === name) return { packageRoot: current, packageJson: candidate };
    } catch {
      // Keep walking: package exports may resolve package.json to an inner dist package.
    }
    if (current === filesystemRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`cannot resolve package root for runtime dependency ${name}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
  const { packageRoot, packageJson: dependency } = await findPackageRoot(name);
  const declaredLicense = typeof dependency.license === "string"
    ? dependency.license
    : Array.isArray(dependency.licenses)
      ? dependency.licenses.map((item) => typeof item === "string" ? item : item?.type).filter(Boolean).join(" OR ")
      : null;
  const licenseFiles = [];
  for (const filename of (await readdir(packageRoot)).sort()) {
    if (!/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(filename)) continue;
    const bytes = await readFile(resolve(packageRoot, filename));
    licenseFiles.push({ filename, sha256: sha256(bytes), byte_count: bytes.byteLength });
  }
  if (!declaredLicense && licenseFiles.length === 0) {
    throw new Error(`runtime dependency ${name} has neither package license metadata nor a top-level license file`);
  }
  rows.push({
    name,
    version: dependency.version,
    declared_license: declaredLicense,
    license_files: licenseFiles,
    evidence_state: declaredLicense ? "DECLARED_LICENSE" : "LICENSE_FILE_PRESENT_METADATA_MISSING",
  });
}

const report = {
  schema: "review-lsp.direct-runtime-licenses.v1",
  package: { name: pkg.name, version: pkg.version, license: pkg.license },
  dependencies: rows,
  note: "Direct runtime dependency evidence only. SPDX is not inferred when package metadata omits it; transitive packages remain governed by their installed license files.",
};
await writeFile(resolve(root, "dist", "review-lsp-licenses.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

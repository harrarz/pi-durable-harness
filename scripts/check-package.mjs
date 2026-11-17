import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.notEqual(manifest.private, true, "package must be publishable");
assert.equal(manifest.license, "MIT");
assert.ok(manifest.keywords?.includes("pi-package"), "Pi gallery discovery keyword is required");
assert.ok(manifest.files?.length, "an explicit publication allowlist is required");
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(lock.name, manifest.name);
assert.equal(lock.version, manifest.version);
assert.ok(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").includes(`## [${manifest.version}]`));
const hostPackages = new Set([
  "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
]);
for (const name of Object.keys(manifest.dependencies ?? {})) {
  assert.ok(!hostPackages.has(name), `host-provided package must be a peer: ${name}`);
}
assert.ok(manifest.dependencies["@earendil-works/pi-durable"], "Durable is a runtime dependency, not supplied by Pi");
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
const paths = new Set(pack.files.map((file) => file.path));
for (const path of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "docs/configuration.md", ...manifest.pi.extensions.map((entry) => entry.replace(/^\.\//, ""))]) {
  assert.ok(paths.has(path), `missing published resource: ${path}`);
}
for (const path of paths) {
  assert.ok(/^(src\/|docs\/configuration\.md$|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$)/.test(path), `unexpected published file: ${path}`);
  assert.ok(!/(^|\/)(\.env(?:\.|$)|auth\.json|node_modules|runtime|\.local-notes)(\/|$)|\.(sqlite|jsonl|bak|log)([.-]|$)/.test(path), `private resource: ${path}`);
  if (!path.startsWith("src/") || !path.endsWith(".ts")) continue;
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/g)) {
    const target = posix.normalize(posix.join(posix.dirname(path), match[1])).replace(/\.js$/, ".ts");
    assert.ok(paths.has(target), `missing relative import ${target} from ${path}`);
  }
}
console.log(`${manifest.name}@${manifest.version}: ${paths.size} approved files; ${pack.size} packed bytes; entry points and imports verified.`);

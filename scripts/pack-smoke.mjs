// Verify the actual tarball with clean runtime dependencies and Pi's package loader. No inference.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-package-"));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const run = (command, args, cwd = root, extra = {}) => execFileSync(command, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000,
  maxBuffer: 10 * 1024 * 1024, ...extra,
});
try {
  const [pack] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch]));
  const install = join(scratch, "install");
  await mkdir(install);
  run("npm", ["install", "--prefix", install, "--ignore-scripts", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", join(scratch, pack.filename)]);
  const installed = join(install, "node_modules", ...manifest.name.split("/"));
  const work = join(scratch, "work");
  await mkdir(work);
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
  const stdout = run(process.execPath, [
    cli, "--offline", "--no-extensions", "-e", installed, "-e", join(root, "test/fixtures/cli-provider.ts"),
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--mode", "json",
    "--provider", "faux", "--model", "faux-1", "--thinking", "off", "--session-dir", join(work, "sessions"),
    "Verify the packaged extension.",
  ], work, { env: { ...process.env, PI_DURABLE_TEST_PHASE: "resume" }, timeout: 30_000 });
  assert.equal(await readFile(join(work, "recovered.txt"), "utf8"), "recovered\n");
  assert.ok(stdout.includes('"type":"agent_settled"'), "packaged extension must work through a settled Pi run");
  const sessions = (await readdir(join(work, "sessions"))).filter((file) => file.endsWith(".jsonl"));
  assert.equal(sessions.length, 1);
  const entries = (await readFile(join(work, "sessions", sessions[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const states = entries.filter((entry) => entry.customType === "pi-durable-harness.run").map((entry) => entry.data.status);
  assert.deepEqual(states, ["started", "completed"]);
  console.log(`${manifest.name}@${manifest.version}: clean tarball installation, Pi package discovery, tools, and Durable receipts passed.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

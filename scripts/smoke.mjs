// Explicitly opt-in live test. Uses the existing Pi Codex login; never creates credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const settings = SettingsManager.create(process.cwd());
const provider = settings.getDefaultProvider();
const model = settings.getDefaultModel();
const runtime = await ModelRuntime.create();
assert.equal(provider, "openai-codex", "Select your Codex model in Pi before running this smoke test.");
assert.ok(model && runtime.getModel(provider, model), "Configured Pi model is not available.");
assert.ok(runtime.isUsingSubscription(provider), "This smoke test requires existing Codex subscription authentication.");
const directory = await mkdtemp(join(tmpdir(), "pi-durable-smoke-"));
const artifact = join(directory, "smoke.txt");
const sessions = join(directory, "sessions");
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const command = process.env.PI_SMOKE_CLI ?? process.execPath;
const running = promisify(execFile)(command, [
  ...(process.env.PI_SMOKE_CLI ? [] : [cli]), "-e", join(root, "src", "index.ts"), "--provider", provider, "--model", model,
  "--mode", "json", "--session-dir", sessions,
  `Local integration smoke test only. Use the bash tool once to run: printf 'pi-durable-smoke-ok\\n' > '${artifact}'. `
    + "Then reply exactly PI_DURABLE_OK. Do not research, browse, or start subagents.",
], { cwd: root, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
// Pi accepts piped input; an unused open stdin pipe would make it wait for EOF.
running.child.stdin.end();
const { stdout, stderr } = await running.catch(async (error) => {
  await writeFile(join(directory, "events.jsonl"), error.stdout ?? "");
  await writeFile(join(directory, "stderr.txt"), error.stderr ?? "");
  throw new Error(`Pi smoke test failed; inspect ${directory}`, { cause: error });
});
await writeFile(join(directory, "events.jsonl"), stdout);
await writeFile(join(directory, "stderr.txt"), stderr);
const events = stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
assert.ok(messages.length, "Pi did not produce an assistant message.");
assert.ok(messages.every((message) => message.provider === provider), "Unexpected inference provider.");
assert.ok(messages.some((message) => message.content.some((part) => part.type === "text" && part.text.includes("PI_DURABLE_OK"))));
assert.equal(await readFile(artifact, "utf8"), "pi-durable-smoke-ok\n");
const entries = [];
for (const file of await readdir(sessions)) {
  if (file.endsWith(".jsonl")) entries.push(...(await readFile(join(sessions, file), "utf8")).trim().split("\n").map(JSON.parse));
}
const markers = entries.filter((entry) => entry.customType === "pi-durable-harness.run");
assert.deepEqual(markers.map((entry) => entry.data.status), ["started", "completed"]);
console.log(`PASS: normal Pi + ${provider}/${model} + bash + Durable receipt`);
console.log(`Artifacts: ${directory}`);

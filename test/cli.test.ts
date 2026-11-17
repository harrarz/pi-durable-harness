import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const harness = join(root, "src/index.ts");
const provider = join(root, "test/fixtures/cli-provider.ts");

function launch(directory: string, phase: string, args: string[], inputGap = false) {
  const extensions = inputGap ? [provider, harness] : [harness, provider];
  const child = fork(cli, ["--no-extensions", ...extensions.flatMap((path) => ["-e", path]), "--no-skills",
    "--no-context-files", "--provider", "faux", "--model", "faux-1", "--thinking", "off", "--mode", "json",
    "--session-dir", join(directory, "sessions"), ...args], {
    cwd: directory, execArgv: [], env: { ...process.env, PI_DURABLE_TEST_PHASE: phase },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "", stdout = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal, stderr, stdout }));
  const ready = new Promise<{ sessionFile: string }>((resolve, reject) => {
    child.once("message", (value) => resolve(value as { sessionFile: string }));
    child.once("exit", (code) => reject(new Error(`CLI exited before checkpoint (${code}): ${stderr}`)));
  });
  // Most invocations are expected to exit normally without sending a checkpoint.
  void ready.catch(() => {});
  return { child, exited, ready };
}

for (const phase of ["after-tool", "input-gap", "after-answer"]) {
  test(`actual headless Pi CLI recovers ${phase}`, { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-durable-cli-"));
    const children: ReturnType<typeof launch>[] = [];
    try {
      const initial = launch(directory, phase, ["Perform the assigned task."], phase === "input-gap");
      children.push(initial);
      const { sessionFile } = await initial.ready;
      initial.child.kill("SIGKILL");
      assert.equal((await initial.exited).signal, "SIGKILL");
      if (phase === "after-tool") {
        const idle = launch(directory, "resume", ["--session", sessionFile]);
        children.push(idle);
        assert.equal((await idle.exited).code, 0);
        await assert.rejects(readFile(join(directory, "recovered.txt")), { code: "ENOENT" });
      }
      const resumed = launch(directory, "resume", ["--session", sessionFile, "/durable-resume"]);
      children.push(resumed);
      const result = await resumed.exited;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await readFile(join(directory, "recovered.txt"), "utf8"), "recovered\n");
      if (phase === "after-tool") assert.equal(await readFile(join(directory, "receipt.txt"), "utf8"), "once\n");
      const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(entries.filter((entry) => entry.customType === "pi-durable-harness.run" && entry.data.status === "started").length, 1);
      assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
      assert.ok(result.stdout.includes('"type":"agent_settled"'), "CLI must wait for the recovered Pi run to settle");
    } finally {
      for (const process of children) {
        if (process.child.exitCode === null && process.child.signalCode === null) {
          process.child.kill("SIGKILL");
          await process.exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}

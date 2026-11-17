import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/pi-process.ts", import.meta.url));
const children = new Set<ChildProcess>();

function launch(args: string[]) {
  const child = fork(fixture, args, { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  child.once("exit", () => children.delete(child));
  let diagnostics = "";
  child.stderr!.on("data", (chunk) => { diagnostics += chunk.toString(); });
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once("message", (value) => resolve(value as Record<string, unknown>));
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Fixture exited (${code}/${signal}): ${diagnostics}`)));
  });
  return { child, message };
}

for (const mode of ["after-tool", "first-request", "unsafe-tool", "after-answer"]) {
  test(`hard-kill recovery: ${mode}`, { timeout: 45_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-durable-kill-"));
    const owned: ChildProcess[] = [];
    try {
      const initial = launch([cwd, mode]);
      owned.push(initial.child);
      const ready = await initial.message;
      assert.equal(ready.type, "ready");
      const exited = once(initial.child, "exit");
      assert.equal(initial.child.kill("SIGKILL"), true);
      const [initialCode, initialSignal] = await exited;
      assert.equal(initialCode, null);
      assert.equal(initialSignal, "SIGKILL");

      const resumed = launch([cwd, "resume", String(ready.file)]);
      owned.push(resumed.child);
      const result = await resumed.message;
      assert.equal(result.type, "result");
      assert.deepEqual(result.errors, []);
      assert.equal(result.starts, 1, "the original run must not be submitted again");
      assert.equal(result.users, 1, "recovery must preserve the original user request, not duplicate it");
      assert.equal(result.calls, 1, "a run without an agent_settled receipt must be recovered, even after an answer");
      assert.equal(result.text, "Recovered from saved Pi session.");
      assert.equal(result.receipt, mode === "after-tool" || mode === "unsafe-tool" ? "once\n" : "");
      const [code] = await once(resumed.child, "exit");
      assert.equal(code, 0);
    } finally {
      for (const child of owned) {
        if (children.has(child)) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

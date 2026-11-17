import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MARKER } from "../src/index.ts";
import { closePi, openPi, until } from "./helpers.ts";

const directory = () => mkdtemp(join(tmpdir(), "pi-durable-integration-"));

test("normal Pi retains its own tools and completes a tracked run", async () => {
  const cwd = await directory();
  const { session, manager, errors } = await openPi(cwd, [
    fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "ordinary Pi tool\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  try {
    await session.prompt("Write result.txt.");
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "ordinary Pi tool\n");
    assert.equal(session.getLastAssistantText(), "Done.");
    const statuses = manager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === MARKER
      ? [(entry.data as { status: string }).status] : []);
    assert.deepEqual(statuses, ["started", "completed"]);
    assert.deepEqual(errors, []);
    assert.ok(session.getActiveToolNames().includes("bash"));
  } finally {
    await closePi(session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an existing Pi delegation tool can run independent agents concurrently", { timeout: 10_000 }, async () => {
  const cwd = await directory();
  let entered = 0;
  let release!: () => void;
  const bothWorking = new Promise<void>((resolve) => { release = resolve; });
  const { session, errors } = await openPi(cwd, [
    fauxAssistantMessage([
      fauxToolCall("existing_agent", { name: "a" }),
      fauxToolCall("existing_agent", { name: "b" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Both agents finished."),
  ], undefined, [(pi) => {
    pi.registerTool({
      name: "existing_agent", label: "Existing agent tool", description: "Fixture for the user's existing delegation extension",
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, { name }) {
        const workspace = join(cwd, name);
        await mkdir(workspace);
        const child = await openPi(workspace, [
          async (request) => {
            assert.ok(!JSON.stringify(request.messages).includes("PRIVATE_MANAGER_CONTEXT"));
            entered++;
            if (entered === 2) release();
            await bothWorking;
            return fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: name }), { stopReason: "toolUse" });
          },
          fauxAssistantMessage(`Finished ${name}.`),
        ]);
        try {
          await child.session.prompt(`Work independently as ${name}.`);
          assert.deepEqual(child.errors, []);
          return { content: [{ type: "text", text: child.session.getLastAssistantText()! }], details: {} };
        } finally { await closePi(child.session); }
      },
    });
  }]);
  try {
    await session.prompt("PRIVATE_MANAGER_CONTEXT: ask both agents to work.");
    assert.equal(entered, 2);
    assert.equal(await readFile(join(cwd, "a", "result.txt"), "utf8"), "a");
    assert.equal(await readFile(join(cwd, "b", "result.txt"), "utf8"), "b");
    assert.equal(session.getLastAssistantText(), "Both agents finished.");
    assert.deepEqual(errors, []);
  } finally {
    await closePi(session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("graceful host shutdown can resume unfinished work in the saved Pi session", async () => {
  const cwd = await directory();
  const first = await openPi(cwd, [() => new Promise<never>(() => {})]);
  void first.session.prompt("Continue this long-running task.").catch(() => {});
  await until(() => first.faux.state.callCount === 1);
  const file = first.manager.getSessionFile()!;
  await closePi(first.session);
  const second = await openPi(cwd, [fauxAssistantMessage("Resumed after close.")], file);
  try {
    await until(() => second.session.getLastAssistantText() === "Resumed after close.");
    assert.equal(second.faux.state.callCount, 1);
    const lastMarker = second.manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === MARKER);
    assert.ok(lastMarker?.type === "custom");
    assert.equal((lastMarker.data as { status: string }).status, "completed");
    assert.deepEqual(second.errors, []);
  } finally {
    await closePi(second.session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("explicit Pi abort remains stopped after reopening", async () => {
  const cwd = await directory();
  const first = await openPi(cwd, [fauxAssistantMessage("Long streaming response. ".repeat(100))], undefined, [], { tokensPerSecond: 20 });
  const prompting = first.session.prompt("Work until I stop you.");
  await until(() => first.faux.state.callCount === 1);
  await first.session.abort();
  await prompting;
  const file = first.manager.getSessionFile()!;
  await closePi(first.session);
  const second = await openPi(cwd, [], file);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(second.faux.state.callCount, 0, "an explicit abort must not auto-resume");
    assert.deepEqual(second.errors, []);
  } finally {
    await closePi(second.session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider failure is recorded and not retried just by reopening", async () => {
  const cwd = await directory();
  const first = await openPi(cwd, [fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" })]);
  await first.session.prompt("Attempt this task.");
  const file = first.manager.getSessionFile()!;
  const lastMarker = first.manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === MARKER);
  assert.ok(lastMarker?.type === "custom");
  assert.equal((lastMarker.data as { status: string }).status, "failed");
  await closePi(first.session);
  const second = await openPi(cwd, [], file);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(second.faux.state.callCount, 0);
    assert.deepEqual(second.errors, []);
  } finally {
    await closePi(second.session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a writer-lock failure blocks inference instead of silently running without persistence", { timeout: 20_000 }, async () => {
  const cwd = await directory();
  const first = await openPi(cwd, [fauxAssistantMessage("Owner session.")]);
  await first.session.prompt("Initialize the owner session.");
  const second = await openPi(cwd, [fauxAssistantMessage("This must never run.")], first.manager.getSessionFile()!);
  try {
    await second.session.prompt("Attempt an unprotected run.");
    assert.equal(second.faux.state.callCount, 0);
    first.faux.appendResponses([fauxAssistantMessage("Owner still works.")]);
    await first.session.prompt("Continue in the owning process.");
    assert.equal(first.session.getLastAssistantText(), "Owner still works.");
  } finally {
    await closePi(second.session);
    await closePi(first.session);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reopening a completed run does not request another model answer", async () => {
  const cwd = await directory();
  const first = await openPi(cwd, [fauxAssistantMessage("Already finished.")]);
  await first.session.prompt("Finish this task.");
  const file = first.manager.getSessionFile()!;
  await closePi(first.session);
  const second = await openPi(cwd, [], file);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(second.faux.state.callCount, 0);
    assert.equal(second.session.getLastAssistantText(), "Already finished.");
    assert.deepEqual(second.errors, []);
  } finally {
    await closePi(second.session);
    await rm(cwd, { recursive: true, force: true });
  }
});

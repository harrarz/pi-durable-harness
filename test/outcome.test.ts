import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MARKER, runOutcome } from "../src/index.ts";

function started() {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(MARKER, { key: "run", status: "started" });
  return manager;
}

test("a final Pi answer does not prove that extension continuations have settled", () => {
  const manager = started();
  manager.appendMessage(fauxAssistantMessage("Answer before a continuation hook."));
  assert.equal(runOutcome(manager.getBranch(), "run"), undefined);
  manager.appendCustomEntry(MARKER, { key: "run", status: "completed" });
  assert.deepEqual(runOutcome(manager.getBranch(), "run"), { status: "completed" });
});

test("suspension and resumption require a new settled receipt", () => {
  const manager = started();
  manager.appendCustomEntry(MARKER, { key: "run", status: "suspended" });
  manager.appendMessage(fauxAssistantMessage("", { stopReason: "aborted" }));
  assert.equal(runOutcome(manager.getBranch(), "run"), undefined);
  manager.appendCustomEntry(MARKER, { key: "run", status: "resuming" });
  manager.appendMessage(fauxAssistantMessage("Recovered."));
  assert.equal(runOutcome(manager.getBranch(), "run"), undefined);
  manager.appendCustomEntry(MARKER, { key: "run", status: "completed" });
  assert.deepEqual(runOutcome(manager.getBranch(), "run"), { status: "completed" });
});

test("an abandoned Pi branch is not replayed into the selected branch", () => {
  assert.deepEqual(runOutcome([], "run"), { status: "detached" });
});

test("a recorded provider failure is not automatically retried", () => {
  const manager = started();
  manager.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" }));
  manager.appendCustomEntry(MARKER, { key: "run", status: "failed" });
  assert.deepEqual(runOutcome(manager.getBranch(), "run"), { status: "failed" });
});

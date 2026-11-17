import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openPersistence, type Outcome, type PiRunDriver } from "../src/persistence.ts";
import { until } from "./helpers.ts";

function driver() {
  let outcome: Outcome | undefined;
  let finish: ((value: Outcome) => void) | undefined;
  let resumed = 0;
  let live = true;
  const errors: unknown[] = [];
  const adapter: PiRunDriver = {
    outcome: () => outcome,
    isLive: () => live,
    resume: () => { resumed++; live = true; },
    wait: (_key, signal) => new Promise((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
      finish = (value) => { outcome = value; signal.removeEventListener("abort", onAbort); resolve(value); };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }),
    report: (error) => errors.push(error),
  };
  return { adapter, errors, ready: () => finish !== undefined, finish: () => finish!({ status: "completed" }),
    markRestored: () => { live = false; }, resumed: () => resumed };
}

test("closing Durable preserves unfinished Pi run receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-receipt-"));
  const firstDriver = driver();
  const first = await openPersistence(directory, firstDriver.adapter);
  try {
    first.resume();
    const id = await first.start({ key: "same-run", prompt: "Original task" });
    assert.equal(await first.start({ key: "same-run", prompt: "Original task" }), id);
    await until(firstDriver.ready);
    assert.equal((await first.inspect()).tasks.length, 1, "reconciliation must not create duplicate receipts");
    await first.close();

    const restored = driver();
    restored.markRestored();
    const second = await openPersistence(directory, restored.adapter);
    try {
      second.resume();
      await until(restored.ready);
      assert.equal(restored.resumed(), 1, "unfinished run must invoke Pi recovery exactly once");
      restored.finish();
      const receipt = await second.wait(id);
      assert.equal(receipt.state.outcome.status, "completed");
      assert.equal((await second.inspect()).tasks.length, 0);
      assert.deepEqual(firstDriver.errors, []);
      assert.deepEqual(restored.errors, []);
    } finally { await second.close(); }
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second writer cannot open the same Durable state", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-lock-"));
  const first = await openPersistence(directory, driver().adapter);
  try {
    await assert.rejects(openPersistence(directory, driver().adapter), { code: "ELOCKED" });
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});
